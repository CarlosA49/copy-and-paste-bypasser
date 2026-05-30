const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { findOptionGroups } = require('../lib/answer-matcher.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('findOptionGroups: returns [] when document has no inputs', () => {
  const d = dom('<p>nothing here</p>');
  assert.deepEqual(findOptionGroups(d.body), []);
});

test('findOptionGroups: groups radios sharing a name', () => {
  const d = dom(
    '<fieldset>' +
      '<label><input type="radio" name="q1" value="a"> First option</label>' +
      '<label><input type="radio" name="q1" value="b"> Second option</label>' +
      '<label><input type="radio" name="q1" value="c"> Third option</label>' +
    '</fieldset>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'radio');
  assert.equal(groups[0].options.length, 3);
  assert.equal(groups[0].options[0].text, 'First option');
  assert.equal(groups[0].options[1].text, 'Second option');
});

test('findOptionGroups: groups checkboxes sharing a name', () => {
  const d = dom(
    '<label><input type="checkbox" name="multi" value="x"> Gradient descent</label>' +
    '<label><input type="checkbox" name="multi" value="y"> Backpropagation</label>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'checkbox');
  assert.equal(groups[0].options.length, 2);
});

test('findOptionGroups: separates groups by name attribute', () => {
  const d = dom(
    '<label><input type="radio" name="q1"> One</label>' +
    '<label><input type="radio" name="q1"> Two</label>' +
    '<label><input type="radio" name="q2"> Alpha</label>' +
    '<label><input type="radio" name="q2"> Beta</label>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 2);
});

test('findOptionGroups: skips disabled inputs', () => {
  const d = dom(
    '<label><input type="radio" name="q1"> A</label>' +
    '<label><input type="radio" name="q1" disabled> B</label>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups[0].options.length, 1);
});

test('findOptionGroups: derives option text from explicit label[for=id] when label does not wrap input', () => {
  const d = dom(
    '<input type="radio" name="q1" id="opt-a"><label for="opt-a">Choice A</label>' +
    '<input type="radio" name="q1" id="opt-b"><label for="opt-b">Choice B</label>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].options[0].text, 'Choice A');
  assert.equal(groups[0].options[1].text, 'Choice B');
});

test('findOptionGroups: handles ARIA radio/checkbox roles on non-input elements', () => {
  const d = dom(
    '<div role="radiogroup">' +
      '<div role="radio" aria-checked="false">Option X</div>' +
      '<div role="radio" aria-checked="false">Option Y</div>' +
    '</div>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'radio');
  assert.equal(groups[0].options[0].text, 'Option X');
});

test('findOptionGroups: two unrelated nameless radio fieldsets are NOT merged', () => {
  const d = dom(
    '<fieldset><label><input type="radio"> A1</label><label><input type="radio"> A2</label></fieldset>' +
    '<fieldset><label><input type="radio"> B1</label><label><input type="radio"> B2</label></fieldset>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 2, 'should produce one group per fieldset');
  assert.equal(groups[0].options.length, 2);
  assert.equal(groups[1].options.length, 2);
  assert.equal(groups[0].options[0].text, 'A1');
  assert.equal(groups[1].options[0].text, 'B1');
});

test('findOptionGroups: nested role="group" containers do not double-count role="checkbox"', () => {
  const d = dom(
    '<div id="outer" role="group">' +
      '<div role="checkbox">Outer-only</div>' +
      '<div id="inner" role="group">' +
        '<div role="checkbox">Shared</div>' +
      '</div>' +
    '</div>'
  );
  const groups = findOptionGroups(d.body);
  // Outer claims both (it is the outermost ancestor of every role=checkbox in its subtree).
  // Inner therefore produces no group.
  const total = groups.reduce(function (n, g) { return n + g.options.length; }, 0);
  assert.equal(total, 2, 'each role=checkbox should be owned by exactly one group');
});

test('findOptionGroups: anonymous ARIA radiogroups get unique names', () => {
  const d = dom(
    '<div role="radiogroup"><div role="radio">X</div></div>' +
    '<div role="radiogroup"><div role="radio">Y</div></div>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].name, groups[1].name, 'anonymous ARIA groups must not collide on name');
});

const { matchCandidates } = require('../lib/answer-matcher.js');

function radioGroup(d, texts) {
  texts.forEach(function (t) {
    const label = d.createElement('label');
    const inp = d.createElement('input');
    inp.type = 'radio'; inp.name = 'q1';
    label.appendChild(inp);
    label.appendChild(d.createTextNode(' ' + t));
    d.body.appendChild(label);
  });
  return findOptionGroups(d.body)[0];
}

test('matchCandidates: letter A → first option of the group', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta', 'Gamma']);
  const matches = matchCandidates([g], { letters: ['A'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].option.index, 0);
  assert.equal(matches[0].reason, 'letter');
});

test('matchCandidates: letter C → third option', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta', 'Gamma']);
  const matches = matchCandidates([g], { letters: ['C'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(matches[0].option.index, 2);
});

test('matchCandidates: number 2 → second option', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta', 'Gamma']);
  const matches = matchCandidates([g], { letters: [], numbers: [2], quotedSnippets: [], rawText: '' });
  assert.equal(matches[0].option.index, 1);
  assert.equal(matches[0].reason, 'number');
});

test('matchCandidates: quoted snippet → option whose label contains the snippet (case-insensitive)', () => {
  const d = dom('');
  const g = radioGroup(d, ['Gradient descent', 'Linear regression', 'Backpropagation']);
  const matches = matchCandidates([g], { letters: [], numbers: [], quotedSnippets: ['BACKPROP'], rawText: '' });
  assert.equal(matches[0].option.index, 2);
  assert.equal(matches[0].reason, 'snippet');
});

test('matchCandidates: snippet falls back to token-overlap when no direct substring match', () => {
  const d = dom('');
  const g = radioGroup(d, ['Stochastic gradient descent optimizer', 'Naive Bayes classifier', 'K-means clustering']);
  const matches = matchCandidates([g], { letters: [], numbers: [], quotedSnippets: ['stochastic optimizer'], rawText: '' });
  assert.equal(matches[0].option.index, 0);
  assert.equal(matches[0].reason, 'overlap');
});

test('matchCandidates: out-of-range letter is ignored, not clamped', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta']); // only A, B exist
  const matches = matchCandidates([g], { letters: ['D'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(matches.length, 0);
});

test('matchCandidates: out-of-range number is ignored', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta']);
  const matches = matchCandidates([g], { letters: [], numbers: [9], quotedSnippets: [], rawText: '' });
  assert.equal(matches.length, 0);
});

test('matchCandidates: radio group caps at one selection even if multiple candidates match', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta']);
  const matches = matchCandidates([g], { letters: ['A', 'B'], numbers: [], quotedSnippets: [], rawText: '' });
  // radio is single-select; only first surviving match is kept
  assert.equal(matches.length, 1);
  assert.equal(matches[0].option.index, 0);
});

test('matchCandidates: checkbox group keeps all matched candidates', () => {
  const d = dom(
    '<label><input type="checkbox" name="m"> One</label>' +
    '<label><input type="checkbox" name="m"> Two</label>' +
    '<label><input type="checkbox" name="m"> Three</label>'
  );
  const g = findOptionGroups(d.body)[0];
  const matches = matchCandidates([g], { letters: ['A', 'C'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].option.index, 0);
  assert.equal(matches[1].option.index, 2);
});

test('matchCandidates: radio tie-break selects lowest index regardless of letter order', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta']);
  const r = matchCandidates([g], { letters: ['B', 'A'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(r.length, 1);
  assert.equal(r[0].option.index, 0); // A (index 0) wins, not B (index 1)
});

const { applyMatches } = require('../lib/answer-matcher.js');

test('applyMatches: checks the matched native radio input', () => {
  const d = dom(
    '<label><input type="radio" name="q1"> Alpha</label>' +
    '<label><input type="radio" name="q1"> Beta</label>'
  );
  const g = findOptionGroups(d.body)[0];
  const matches = matchCandidates([g], { letters: ['B'], numbers: [], quotedSnippets: [], rawText: '' });
  const summary = applyMatches(matches);
  assert.equal(summary.selected, 1);
  assert.equal(summary.skipped, 0);
  // Find the radio after Beta's label text
  const radios = d.querySelectorAll('input[type="radio"]');
  assert.equal(radios[0].checked, false);
  assert.equal(radios[1].checked, true);
});

test('applyMatches: checks multiple matched checkboxes', () => {
  const d = dom(
    '<label><input type="checkbox" name="m"> One</label>' +
    '<label><input type="checkbox" name="m"> Two</label>' +
    '<label><input type="checkbox" name="m"> Three</label>'
  );
  const g = findOptionGroups(d.body)[0];
  const matches = matchCandidates([g], { letters: ['A', 'C'], numbers: [], quotedSnippets: [], rawText: '' });
  const summary = applyMatches(matches);
  assert.equal(summary.selected, 2);
  const boxes = d.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false);
  assert.equal(boxes[2].checked, true);
});

test('applyMatches: dispatches click, input, change in browser-native order', () => {
  const d = dom('<label><input type="radio" name="q1"> Alpha</label>');
  const g = findOptionGroups(d.body)[0];
  const inp = d.querySelector('input');
  const fired = [];
  inp.addEventListener('click',  function () { fired.push('click'); });
  inp.addEventListener('input',  function () { fired.push('input'); });
  inp.addEventListener('change', function () { fired.push('change'); });
  const matches = matchCandidates([g], { letters: ['A'], numbers: [], quotedSnippets: [], rawText: '' });
  applyMatches(matches);
  assert.deepEqual(fired, ['click', 'input', 'change']);
});

test('applyMatches: skips matches whose element is detached', () => {
  const d = dom('<label><input type="radio" name="q1"> Alpha</label>');
  const g = findOptionGroups(d.body)[0];
  const matches = matchCandidates([g], { letters: ['A'], numbers: [], quotedSnippets: [], rawText: '' });
  d.querySelector('input').remove();
  const summary = applyMatches(matches);
  assert.equal(summary.selected, 0);
  assert.equal(summary.skipped, 1);
});

test('applyMatches: clicks ARIA role=radio elements (no native input)', () => {
  const d = dom(
    '<div role="radiogroup">' +
      '<div role="radio" aria-checked="false">X</div>' +
      '<div role="radio" aria-checked="false">Y</div>' +
    '</div>'
  );
  const g = findOptionGroups(d.body)[0];
  let clicks = 0;
  d.querySelectorAll('[role="radio"]').forEach(function (el) { el.addEventListener('click', function () { clicks += 1; }); });
  const matches = matchCandidates([g], { letters: ['B'], numbers: [], quotedSnippets: [], rawText: '' });
  const summary = applyMatches(matches);
  assert.equal(summary.selected, 1);
  assert.equal(clicks, 1);
});

test('applyMatches: returns { selected: 0, skipped: 0 } for empty match list', () => {
  const summary = applyMatches([]);
  assert.deepEqual(summary, { selected: 0, skipped: 0 });
});

const { findTextInputs } = require('../lib/answer-matcher.js');

test('findTextInputs: returns [] when page has no text inputs', () => {
  const d = dom('<p>nothing here</p>');
  assert.deepEqual(findTextInputs(d.body), []);
});

test('findTextInputs: finds an <input type="text">', () => {
  const d = dom('<input type="text" id="t1">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'input');
  assert.equal(list[0].el.id, 't1');
});

test('findTextInputs: finds an <input type="number">', () => {
  const d = dom('<input type="number" id="n1">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'input');
});

test('findTextInputs: skips type="radio" and type="checkbox"', () => {
  const d = dom('<input type="radio" name="r"><input type="checkbox" name="c">');
  assert.deepEqual(findTextInputs(d.body), []);
});

test('findTextInputs: finds a <textarea>', () => {
  const d = dom('<textarea id="ta"></textarea>');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'textarea');
});

test('findTextInputs: finds a [contenteditable="true"] div', () => {
  const d = dom('<div id="ce" contenteditable="true">hi</div>');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'contenteditable');
});

test('findTextInputs: skips disabled / readonly inputs', () => {
  const d = dom(
    '<input type="text" disabled>' +
    '<input type="text" readonly>' +
    '<input type="text" id="ok">'
  );
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: preserves discovery order', () => {
  const d = dom(
    '<input type="text" id="a">' +
    '<textarea id="b"></textarea>' +
    '<input type="number" id="c">'
  );
  const list = findTextInputs(d.body);
  assert.deepEqual(list.map(function (x) { return x.el.id; }), ['a', 'b', 'c']);
});

const { matchTextInputs } = require('../lib/answer-matcher.js');

test('matchTextInputs: returns [] when there are no computed values', () => {
  const d = dom('<input type="text" id="t">');
  const tis = findTextInputs(d.body);
  const matches = matchTextInputs(tis, { computedValues: [] });
  assert.deepEqual(matches, []);
});

test('matchTextInputs: returns [] when there are no text inputs', () => {
  const matches = matchTextInputs([], { computedValues: [{ value: '500', unit: '', raw: '500' }] });
  assert.deepEqual(matches, []);
});

test('matchTextInputs: pairs values to inputs in order', () => {
  const d = dom('<input type="text" id="a"><input type="text" id="b">');
  const tis = findTextInputs(d.body);
  const matches = matchTextInputs(tis, {
    computedValues: [
      { value: '500', unit: 'turns', raw: '500 turns' },
      { value: '200', unit: 'mH', raw: '200 mH' },
    ],
  });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].el.id, 'a');
  assert.equal(matches[0].value, '500 turns');
  assert.equal(matches[1].el.id, 'b');
  assert.equal(matches[1].value, '200 mH');
});

test('matchTextInputs: extra inputs without a corresponding value are skipped', () => {
  const d = dom('<input type="text" id="a"><input type="text" id="b"><input type="text" id="c">');
  const tis = findTextInputs(d.body);
  const matches = matchTextInputs(tis, {
    computedValues: [{ value: '500', unit: '', raw: '500' }],
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].el.id, 'a');
});

test('matchTextInputs: each match carries reason "computedValue"', () => {
  const d = dom('<input type="text" id="a">');
  const tis = findTextInputs(d.body);
  const matches = matchTextInputs(tis, {
    computedValues: [{ value: '500', unit: '', raw: '500' }],
  });
  assert.equal(matches[0].reason, 'computedValue');
});

const { applyTextMatches } = require('../lib/answer-matcher.js');

test('applyTextMatches: fills an <input type="text"> with the value', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  const summary = applyTextMatches([{ el: el, value: '500 turns', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(el.value, '500 turns');
});

test('applyTextMatches: fills a <textarea> with the value', () => {
  const d = dom('<textarea id="t"></textarea>');
  const el = d.getElementById('t');
  applyTextMatches([{ el: el, value: 'hello', reason: 'computedValue' }]);
  assert.equal(el.value, 'hello');
});

test('applyTextMatches: fills a contenteditable element with the value', () => {
  const d = dom('<div id="ce" contenteditable="true"></div>');
  const el = d.getElementById('ce');
  applyTextMatches([{ el: el, value: '6.3 MHz', reason: 'computedValue' }]);
  assert.equal(el.textContent, '6.3 MHz');
});

test('applyTextMatches: dispatches input and change events on <input>', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  const fired = [];
  el.addEventListener('input', function () { fired.push('input'); });
  el.addEventListener('change', function () { fired.push('change'); });
  applyTextMatches([{ el: el, value: 'x', reason: 'computedValue' }]);
  assert.deepEqual(fired, ['input', 'change']);
});

test('applyTextMatches: dispatches input event on contenteditable', () => {
  const d = dom('<div id="ce" contenteditable="true"></div>');
  const el = d.getElementById('ce');
  let inputCount = 0;
  el.addEventListener('input', function () { inputCount += 1; });
  applyTextMatches([{ el: el, value: 'x', reason: 'computedValue' }]);
  assert.equal(inputCount, 1);
});

test('applyTextMatches: skips detached elements', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  el.remove();
  const summary = applyTextMatches([{ el: el, value: 'x', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
});

test('applyTextMatches: returns filled:0, skipped:0 for empty list', () => {
  const s = applyTextMatches([]);
  assert.equal(s.filled, 0);
  assert.equal(s.skipped, 0);
});

test('applyTextMatches: returns filled:0, skipped:0 for non-array input', () => {
  const s = applyTextMatches(null);
  assert.equal(s.filled, 0);
  assert.equal(s.skipped, 0);
});

test('findTextInputs: skips <input type="hidden">', () => {
  const d = dom('<input type="hidden" id="h"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips <input hidden> (the HTML hidden attribute)', () => {
  const d = dom('<input type="text" hidden id="h"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips <input style="display:none">', () => {
  const d = dom('<input type="text" id="h" style="display:none"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips inputs inside a display:none ancestor', () => {
  const d = dom('<div style="display:none"><input type="text" id="h"></div><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips aria-hidden="true" inputs', () => {
  const d = dom('<input type="text" id="h" aria-hidden="true"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips inputs inside an aria-hidden ancestor', () => {
  const d = dom('<div aria-hidden="true"><input type="text" id="h"></div><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips visibility:hidden', () => {
  const d = dom('<input type="text" id="h" style="visibility:hidden"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: type="search" is no longer included (Coursera answer boxes are text/number)', () => {
  const d = dom('<input type="search" id="s"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: 12 visible answer boxes among extra hidden inputs counts exactly 12', () => {
  // Real-world scenario: a page has 12 visible answer boxes plus 2 hidden
  // React/framework inputs. findTextInputs returns exactly 12.
  let html = '<input type="hidden" name="csrf">';
  for (let i = 0; i < 12; i++) html += '<input type="text" name="q' + i + '">';
  html += '<div style="display:none"><input type="text" name="internal"></div>';
  const d = dom(html);
  const list = findTextInputs(d.body);
  assert.equal(list.length, 12);
});

test('applyTextMatches: strips leading "= " from the raw value before filling', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  applyTextMatches([{ el: el, value: '= 1.0e-6 H', reason: 'computedValue' }]);
  // The "= " prefix is stripped before the field is touched.
  assert.equal(el.value, '1.0e-6 H');
});

test('applyTextMatches: strips "answer = " / "Final: " prefixes', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  applyTextMatches([{ el: el, value: 'Final: answer = 42 J', reason: 'computedValue' }]);
  assert.equal(el.value, '42 J');
});

test('applyTextMatches: falls back to numeric-only when full raw is rejected', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  // Override the value descriptor to reject letters.
  let storedValue = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return storedValue; },
    set: function (v) { storedValue = /[A-Za-z]/.test(v) ? '' : String(v); },
  });
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  // Variant 0 "1.0e-6 H" contains letters → rejected. Variant 1 "1.0e-6"
  // contains 'e' which is also a letter → rejected. Variant 2 plain-decimal
  // "0.000001" has no letters → accepted.
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '0.000001');
});

test('applyTextMatches: records a skip reason when every variant is rejected', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  // Reject every set attempt entirely.
  let storedValue = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return storedValue; },
    set: function (_v) { storedValue = ''; },
  });
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
  assert.ok(Array.isArray(summary.reasons));
  assert.equal(summary.reasons.length, 1);
  // Reason is the canonical machine-readable code; sidebar translates to human text.
  assert.ok(summary.reasons[0] === 'rejected-empty' || summary.reasons[0] === 'value-did-not-stick');
});

test('applyTextMatches: one failed field does not stop subsequent fills', () => {
  const d = dom('<input type="text" id="bad"><input type="text" id="ok">');
  const bad = d.getElementById('bad');
  const ok = d.getElementById('ok');
  // bad rejects everything; ok accepts.
  Object.defineProperty(bad, 'value', {
    configurable: true,
    get: function () { return ''; },
    set: function () { /* swallow */ },
  });
  const summary = applyTextMatches([
    { el: bad, value: '1.0e-6 H', reason: 'computedValue' },
    { el: ok,  value: '0.0352 H', reason: 'computedValue' },
  ]);
  assert.equal(summary.filled, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(ok.value, '0.0352 H');
});

test('applyTextMatches: returns reasons:[] when input list is empty', () => {
  const summary = applyTextMatches([]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 0);
  assert.deepEqual(summary.reasons, []);
});

test('applyTextMatches: detached element produces skip reason "detached"', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  el.remove();
  const summary = applyTextMatches([{ el: el, value: 'x', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.reasons[0], 'detached');
});

test('regression: leading "= " removed before fill (chip + actual value)', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  const summary = applyTextMatches([{ el: el, value: '= 1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '1.0e-6 H'); // no "= " prefix in the field
});

test('regression: value+unit field can fall back to numeric-only', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  // Reject any value containing a letter (units like H/F/etc.).
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) { stored = /[A-Za-z]/.test(v) ? '' : String(v); },
  });
  // The value has "e" in "1.0e-6" so that ALSO fails the letter test.
  // The final fallback variant is the plain-decimal expansion "0.000001".
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '0.000001');
});

test('regression: every variant rejected → field is skipped with a reason', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  // Reject every set attempt.
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return ''; },
    set: function () { /* swallow */ },
  });
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
  // Reason is one of the canonical machine-readable codes.
  assert.ok(['rejected-empty', 'value-did-not-stick'].indexOf(summary.reasons[0]) !== -1);
});

test('regression: a failed field does not stop subsequent fields from filling', () => {
  const d = dom(
    '<input type="text" id="bad">' +
    '<input type="text" id="ok">' +
    '<input type="text" id="also-ok">'
  );
  const bad = d.getElementById('bad');
  // bad rejects everything.
  Object.defineProperty(bad, 'value', {
    configurable: true,
    get: function () { return ''; },
    set: function () {},
  });
  const summary = applyTextMatches([
    { el: bad, value: 'a', reason: 'computedValue' },
    { el: d.getElementById('ok'), value: 'b', reason: 'computedValue' },
    { el: d.getElementById('also-ok'), value: 'c', reason: 'computedValue' },
  ]);
  assert.equal(summary.filled, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(d.getElementById('ok').value, 'b');
  assert.equal(d.getElementById('also-ok').value, 'c');
});

test('regression: hidden / aria-hidden / display:none inputs are NOT discovered', () => {
  const d = dom(
    '<input type="hidden" name="csrf">' +
    '<input type="text" id="ok-1">' +
    '<input type="text" id="hidden-1" hidden>' +
    '<div style="display:none"><input type="text" id="hidden-2"></div>' +
    '<div aria-hidden="true"><input type="text" id="hidden-3"></div>' +
    '<input type="text" id="ok-2">'
  );
  const list = findTextInputs(d.body);
  assert.equal(list.length, 2);
  const ids = list.map(function (x) { return x.el.id; });
  assert.deepEqual(ids, ['ok-1', 'ok-2']);
});

test('regression: 12 visible answer boxes + 12 values fills 12/12 (no off-by-N)', () => {
  let html = '<input type="hidden" name="csrf">';
  for (let i = 0; i < 12; i++) html += '<input type="text" name="q' + i + '">';
  html += '<div style="display:none"><input type="text" name="internal-react"></div>';
  const d = dom(html);
  const inputs = findTextInputs(d.body);
  assert.equal(inputs.length, 12);

  const parsed = { computedValues: [] };
  for (let i = 0; i < 12; i++) {
    parsed.computedValues.push({ value: String(i + 1), unit: 'H', raw: (i + 1) + ' H', confidence: 'high', label: String(i + 1) });
  }
  const matches = matchTextInputs(inputs, parsed);
  assert.equal(matches.length, 12);
  const summary = applyTextMatches(matches);
  assert.equal(summary.filled, 12);
  assert.equal(summary.skipped, 0);
});

test('regression: plain-decimal variant for 0.0352 does not emit float-imprecision artefacts', () => {
  // Reject any value containing a letter so the numeric variant runs.
  // Then probe: the plain-decimal fallback must NOT be "0.03520000000000000212".
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) { stored = /[A-Za-z]/.test(v) ? '' : String(v); },
  });
  const summary = applyTextMatches([{ el: el, value: '0.0352e0 H', reason: 'computedValue' }]);
  // Variants tried in order: "0.0352e0 H" (letters), "0.0352e0" (still has e),
  // then plain-decimal of 0.0352 == "0.0352" (no letters → accepted).
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '0.0352');
});

test('regression: third variant (plain-decimal) is the one that wins (pinned via variantIndex)', () => {
  // Construct a scenario where ONLY the plain-decimal expansion succeeds:
  //   value = "1.0e-6 H"
  //   variant 0 "1.0e-6 H"   → has letters → rejected
  //   variant 1 "1.0e-6"     → has letter 'e' → rejected
  //   variant 2 "0.000001"   → no letters → accepted
  // The results array exposes variantIndex so we can assert variant 2 was used.
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) { stored = /[A-Za-z]/.test(v) ? '' : String(v); },
  });
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(summary.results.length, 1);
  // The successful variant index must be 2 (the plain-decimal expansion).
  assert.equal(summary.results[0].variantIndex, 2);
  assert.equal(summary.results[0].valueUsed, '0.000001');
});

test('applyTextMatches: setter that throws is treated as a rejected variant; pipeline continues', () => {
  // First variant set throws (simulates the type="number" DOMException). The
  // pipeline must NOT propagate the throw — it must record a reason and try
  // the next variant.
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  let attempts = 0;
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) {
      attempts += 1;
      // First set attempt throws; subsequent attempts succeed.
      if (attempts === 1) throw new Error('value rejected by field');
      stored = String(v);
    },
  });
  let threw = false;
  let summary;
  try {
    summary = applyTextMatches([{ el: el, value: '6.0781e-10 H', reason: 'computedValue' }]);
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, false, 'applyTextMatches must not let setter throws escape');
  assert.equal(summary.filled, 1, 'fallback variant should succeed');
  // Variant 0 (the full string) threw; variant 1 ("6.0781e-10") was accepted.
  assert.equal(el.value, '6.0781e-10');
});

test('applyTextMatches: setter that ALWAYS throws — field is skipped with reason "rejected-throw"', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return ''; },
    set: function () { throw new Error('always throws'); },
  });
  const summary = applyTextMatches([{ el: el, value: '1 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.reasons[0], 'rejected-throw');
});

test('applyTextMatches: <input type="number"> with value "6.0781e-10 F" fills as "6.0781e-10"', () => {
  // The live-Coursera bug: number inputs reject the unit-containing variant.
  // buildVariants should drop "6.0781e-10 F" (it has letter 'F') before any
  // setter is touched, so the first attempted variant is "6.0781e-10".
  const d = dom('<input type="number" id="t">');
  const el = d.getElementById('t');
  const summary = applyTextMatches([{ el: el, value: '6.0781e-10 F', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '6.0781e-10');
  // Pin the variantIndex: the numeric-only form is index 0 of the FILTERED
  // variant list (the unit-containing form was dropped before the loop ran).
  assert.equal(summary.results[0].variantIndex, 0);
  assert.equal(summary.results[0].valueUsed, '6.0781e-10');
});

test('applyTextMatches: <input type="number"> falls back to plain-decimal when scientific notation is rejected', () => {
  // Some number widgets reject scientific notation but accept decimal expansion.
  // Construct one that rejects strings containing 'e' but accepts pure digits/dot.
  const d = dom('<input type="number" id="t">');
  const el = d.getElementById('t');
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) { stored = /[eE]/.test(v) ? '' : String(v); },
  });
  // For value "1.0e-6 F" on a number input:
  //   buildVariants produces ["1.0e-6 F", "1.0e-6", "0.000001"]
  //   isNumberShaped filter drops "1.0e-6 F" → ["1.0e-6", "0.000001"]
  //   variant 0 "1.0e-6" rejected (contains 'e') → empty stored
  //   variant 1 "0.000001" accepted → stored = "0.000001"
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 F', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(stored, '0.000001');
  // Pin the variantIndex: the plain-decimal expansion is index 1 of the filtered list.
  assert.equal(summary.results[0].variantIndex, 1);
  assert.equal(summary.results[0].valueUsed, '0.000001');
});

test('applyTextMatches: dot-leading number ".5 F" extracts ".5" (not "5")', () => {
  // Regression: previously the numeric-extraction regex required at least one
  // digit before the decimal point, so ".5 F" matched "5" and dropped the
  // dot. Fixed regex now accepts dot-leading forms.
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) { stored = /[A-Za-z]/.test(v) ? '' : String(v); },
  });
  const summary = applyTextMatches([{ el: el, value: '.5 F', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  // Variant 0 ".5 F" rejected (has F). Variant 1 ".5" accepted.
  assert.equal(stored, '.5');
});

test('applyTextMatches: dot-leading negative "-.5 F" extracts "-.5" (not "5")', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) { stored = /[A-Za-z]/.test(v) ? '' : String(v); },
  });
  const summary = applyTextMatches([{ el: el, value: '-.5 F', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  // Variant 0 "-.5 F" rejected. Variant 1 "-.5" accepted (negative sign preserved).
  assert.equal(stored, '-.5');
});

test('findOptionGroups ignores the extension sidebar radios (name=ccp-behavior under #ccp-host-root)', () => {
  const { findOptionGroups } = require('../lib/answer-matcher.js');
  const d = dom(
    '<div id="ccp-host-root"><div class="ccp-host">' +
      '<input type="radio" name="ccp-behavior" value="a"><input type="radio" name="ccp-behavior" value="b">' +
    '</div></div>' +
    '<fieldset><input type="radio" name="q1"><input type="radio" name="q1"></fieldset>'
  );
  const groups = findOptionGroups(d.body);
  // Only the real quiz radio group survives; ccp-behavior is excluded.
  const names = groups.map(function (g) { return g.name; });
  assert.ok(names.indexOf('ccp-behavior') === -1, 'ccp-behavior group must be excluded');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'q1');
});

test('findTextInputs ignores the Boost chat composer textarea and the extension paste box', () => {
  const { findTextInputs } = require('../lib/answer-matcher.js');
  const d = dom(
    '<div id="boostai-chat-panel-composer"><textarea placeholder="Ask your question here"></textarea></div>' +
    '<div class="ccp-host"><textarea placeholder="Paste or type text..."></textarea></div>' +
    '<textarea id="real-answer"></textarea>'
  );
  const inputs = findTextInputs(d.body);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].el.id, 'real-answer');
});

test('findTextInputs: discovers a .mq-editable-field MathQuill target', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<span class="mq-editable-field" contenteditable="true"></span>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const doc = j.window.document;
  const found = findTextInputs(doc.body);
  assert.equal(found.length, 1, 'MathQuill field must be discovered');
  assert.equal(found[0].kind, 'mathquill');
});

test('findOptionGroups: label-wrapped cds- options without role=radio are discovered as a group', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-1">' +
      '<label class="cds-checkboxAndRadio-label"><div class="cds-1">Alpha</div></label>' +
      '<label class="cds-checkboxAndRadio-label"><div class="cds-1">Beta</div></label>' +
      '<label class="cds-checkboxAndRadio-label"><div class="cds-1">Gamma</div></label>' +
    '</div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const doc = j.window.document;
  const groups = findOptionGroups(doc.querySelector('[data-testid="cml-question-1"]'));
  assert.equal(groups.length, 1, 'one label-wrapped option group');
  assert.equal(groups[0].options.length, 3);
  assert.deepEqual(groups[0].options.map(function (o) { return o.text; }), ['Alpha', 'Beta', 'Gamma']);
});
