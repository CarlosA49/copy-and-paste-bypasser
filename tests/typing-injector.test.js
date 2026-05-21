const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { insertOrBackspace, isEditable } = require('../lib/typing-injector.js');

function setup(html) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>');
  return dom.window.document;
}

test('isEditable: returns false for null target', () => {
  assert.equal(isEditable(null), false);
});

test('isEditable: textarea is editable', () => {
  const d = setup('<textarea id="t"></textarea>');
  assert.equal(isEditable(d.getElementById('t')), true);
});

test('isEditable: input[type=text] is editable', () => {
  const d = setup('<input id="t" type="text">');
  assert.equal(isEditable(d.getElementById('t')), true);
});

test('isEditable: input[type=checkbox] is NOT editable', () => {
  const d = setup('<input id="t" type="checkbox">');
  assert.equal(isEditable(d.getElementById('t')), false);
});

test('isEditable: contenteditable div is editable', () => {
  const d = setup('<div id="t" contenteditable="true">hi</div>');
  assert.equal(isEditable(d.getElementById('t')), true);
});

test('isEditable: plain div is NOT editable', () => {
  const d = setup('<div id="t">hi</div>');
  assert.equal(isEditable(d.getElementById('t')), false);
});

test('isEditable: disabled textarea is NOT editable', () => {
  const d = setup('<textarea id="t" disabled></textarea>');
  assert.equal(isEditable(d.getElementById('t')), false);
});

test('isEditable: readonly input is NOT editable', () => {
  const d = setup('<input id="t" readonly>');
  assert.equal(isEditable(d.getElementById('t')), false);
});

test('insertOrBackspace appends a character to a textarea', () => {
  const d = setup('<textarea id="t">ab</textarea>');
  const el = d.getElementById('t');
  let inputEvents = 0;
  el.addEventListener('input', function () { inputEvents += 1; });
  const ok = insertOrBackspace(el, { kind: 'char', char: 'c' });
  assert.equal(ok, true);
  assert.equal(el.value, 'abc');
  assert.equal(inputEvents, 1);
});

test('insertOrBackspace removes the last char on backspace', () => {
  const d = setup('<textarea id="t">abc</textarea>');
  const el = d.getElementById('t');
  const ok = insertOrBackspace(el, { kind: 'backspace' });
  assert.equal(ok, true);
  assert.equal(el.value, 'ab');
});

test('insertOrBackspace appends to a contenteditable element', () => {
  const d = setup('<div id="t" contenteditable="true">ab</div>');
  const el = d.getElementById('t');
  const ok = insertOrBackspace(el, { kind: 'char', char: 'c' });
  assert.equal(ok, true);
  assert.equal(el.textContent, 'abc');
});

test('insertOrBackspace refuses to write to a non-editable element', () => {
  const d = setup('<div id="t">hi</div>');
  const el = d.getElementById('t');
  const ok = insertOrBackspace(el, { kind: 'char', char: 'X' });
  assert.equal(ok, false);
  assert.equal(el.textContent, 'hi');
});

test('insertOrBackspace returns false when target is detached', () => {
  const d = setup('<textarea id="t">ab</textarea>');
  const el = d.getElementById('t');
  el.remove();
  const ok = insertOrBackspace(el, { kind: 'char', char: 'c' });
  assert.equal(ok, false);
});
