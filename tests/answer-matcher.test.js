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

test('applyTextMatches: returns { filled: 0, skipped: 0 } for empty list', () => {
  assert.deepEqual(applyTextMatches([]), { filled: 0, skipped: 0 });
});

test('applyTextMatches: returns { filled: 0, skipped: 0 } for non-array input', () => {
  assert.deepEqual(applyTextMatches(null), { filled: 0, skipped: 0 });
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
