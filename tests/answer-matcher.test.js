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
